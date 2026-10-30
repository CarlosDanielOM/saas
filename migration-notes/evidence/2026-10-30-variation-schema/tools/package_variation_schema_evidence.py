#!/usr/bin/env python3
"""Package final moderation variation schema evidence from immutable receipts and Git."""
import gzip
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path('/root/saas-rust')
STATE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
ART = STATE / 'artifacts'
SCHEMA_ART = ART / 'moderation-variation-schema'
OUT = ROOT / 'migration-notes/evidence/2026-10-30-variation-schema'
COMMIT = '3b5b92b6040e622f47467299db6eed76242951f8'
FINAL = 'compiler-fixtures-1793337057616332027'
FINAL_NODE = 'node-1793337045953211227'
FIRST = 1793336331204290489
LAST = 1793337057616332027
SDK_SOURCE = ROOT / 'migration-notes/evidence/2026-10-30-moderation-variations/source-bindings.json'
PREVIOUS_SDK_KEY = 'cache-and-types'
SDK_PREFIX = 'verification/posthog-rs/'

sha = lambda b: hashlib.sha256(b).hexdigest()

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def load(path):
    return json.loads(path.read_text())

def put(rel, raw, compress=False):
    dest = OUT / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        raise RuntimeError(f'refusing overwrite: {dest}')
    dest.write_bytes(raw)
    row = {'sha256': sha(raw), 'bytes': len(raw), 'rawSha256': sha(raw), 'rawBytes': len(raw), 'compressed': False}
    if compress:
        packed = gzip.compress(raw, mtime=0)
        gz = dest.with_name(dest.name + '.gz')
        gz.write_bytes(packed)
        row.update({'compressedSha256': sha(packed), 'compressedBytes': len(packed), 'compressedPath': str(gz.relative_to(OUT))})
    return row

def main():
    assert git('rev-parse', COMMIT).decode().strip() == COMMIT
    assert not OUT.exists(), f'evidence target already exists: {OUT}'
    OUT.mkdir(parents=True)
    final_receipt = load(ART / f'{FINAL}-receipt.json')
    node_receipt = load(ART / f'{FINAL_NODE}-receipt.json')
    assert final_receipt['success'] and node_receipt['success']
    assert final_receipt['source_tree_sha256'] == 'ecf01f50421602aec6dba6f7ccf9811e47691816a1817fbca8185b3f7756af83'
    assert node_receipt['source_tree_sha256'] == final_receipt['source_tree_sha256']
    hashes = final_receipt['source_hashes']
    assert len(hashes) == 1406
    assert sha(json.dumps(hashes, sort_keys=True).encode()) == final_receipt['source_tree_sha256']

    prev = load(SDK_SOURCE)[PREVIOUS_SDK_KEY]['archiveVerifiedSdkInputs']
    sdk = {p: h for p, h in hashes.items() if p.startswith(SDK_PREFIX)}
    assert len(sdk) == 10 and sdk == prev
    tracked = {}
    for path, expected in hashes.items():
        if path in sdk:
            continue
        actual = sha(git('show', f'{COMMIT}:{path}'))
        assert actual == expected, (path, expected, actual)
        tracked[path] = expected
    assert len(tracked) == 1396

    bindings = {
        'codeCommit': COMMIT,
        'receipt': FINAL,
        'sourceTreeSha256': final_receipt['source_tree_sha256'],
        'sourceInputCount': len(hashes),
        'gitInputCount': len(tracked),
        'gitInputs': tracked,
        'reusedVerifiedSdkInputs': {
            'sourceEvidence': '../../2026-10-30-moderation-variations/source-bindings.json',
            'sourceBinding': PREVIOUS_SDK_KEY,
            'gitCommit': load(SDK_SOURCE)[PREVIOUS_SDK_KEY]['gitCommit'],
            'inputs': sdk,
        },
    }
    (OUT / 'source-bindings.json').write_text(json.dumps(bindings, indent=2, sort_keys=True) + '\n')

    retained = {}
    # Keep every full receipt and stdout/stderr log from the requested run interval.
    runs = []
    for receipt_path in sorted(ART.glob('*-receipt.json')):
        run = receipt_path.name.removesuffix('-receipt.json')
        digits = run.rsplit('-', 1)[-1]
        if digits.isdigit() and FIRST <= int(digits) <= LAST:
            runs.append(run)
    assert len(runs) == 10, runs
    for run in runs:
        for suffix in ('-receipt.json', '.log'):
            path = ART / (run + suffix)
            assert path.is_file(), path
            raw = path.read_bytes()
            rel = Path('runs') / path.name
            retained[str(rel)] = put(rel, raw, compress=True)

    # Preserve all four frozen oracle attempts plus the final production readback.
    for path in sorted(SCHEMA_ART.rglob('*')):
        if not path.is_file():
            continue
        rel = Path('artifacts/moderation-variation-schema') / path.relative_to(SCHEMA_ART)
        retained[str(rel)] = put(rel, path.read_bytes(), compress=False)

    final_ref = SCHEMA_ART / 'attempt4/reference/moderation-variation-schema-reference.json'
    reference = load(final_ref)
    assert len(reference['cases']) == 42
    ref_hash = sha(final_ref.read_bytes())
    assert ref_hash == '6afcb081ec891116bc63cc3d1f8ce2e9e00876fc082c9533df07fe3e05f1d870'

    # Copy exact provenance/reproduction tools; include the shared source freeze chain.
    source_tools = ROOT / 'migration-notes/evidence/2026-10-30-moderation-variations/tools'
    tool_names = [
        'apply_format.py', 'final_readback.py',
        'freeze_variations.py', 'freeze_variations_candidate.py', 'freeze_variations_stable.py',
        'freeze_rule_dispatcher.py', 'freeze_offenses.py', 'freeze_permit.py',
        'freeze_redis_application.py', 'freeze_seed_plan.py', 'freeze_seed_retirement.py',
        'freeze_advanced_oracle.py', 'prepare_posthog_sdk.py',
    ]
    for name in tool_names:
        src = source_tools / name
        if src.is_file():
            rel = Path('tools') / name
            retained[str(rel)] = put(rel, src.read_bytes(), compress=False)
    for src in sorted(Path(__file__).parent.glob('variation_schema_*.sh')):
        rel = Path('tools') / src.name
        retained[str(rel)] = put(rel, src.read_bytes(), compress=False)
    # Include precise isolated workflow and the schema-specific oracle commands.
    for name, src in [('validate.py', STATE / 'validate.py'), ('freeze_variation_schema.py', Path(__file__).parent / 'freeze_variation_schema.py'), ('variation_schema_oracle1.sh', Path(__file__).parent / 'variation_schema_oracle1.sh'), ('variation_schema_negative1.sh', Path(__file__).parent / 'variation_schema_negative1.sh'), ('materialize_variation_schema_source.py', Path(__file__).parent / 'materialize_variation_schema_source.py'), ('package_variation_schema_evidence.py', Path(__file__).resolve())]:
        retained[str(Path('tools') / name)] = put(Path('tools') / name, src.read_bytes())

    readme = '''# Moderation variation schema evidence\n\nThis bundle records the final source-bound validation for moderation variation cache/job schemas. The code was frozen at Git commit `3b5b92b6040e622f47467299db6eed76242951f8`; the accepted compiler-fixture run consumed the 1,406-input tree `ecf01f50421602aec6dba6f7ccf9811e47691816a1817fbca8185b3f7756af83`. `source-bindings.json` hashes every input against Git at that commit (1,396 inputs) and links the ten unchanged `verification/posthog-rs/` SDK inputs to the earlier verified source binding.\n\nThe attempt 4 Mongoose oracle reference contains exactly 42 cases (21 inputs against each model). Its full BSON wire bytes match the Rust compatibility result. Reference SHA-256: `6afcb081ec891116bc63cc3d1f8ce2e9e00876fc082c9533df07fe3e05f1d870`. Attempts 1–3 and the final readback are retained alongside the accepted oracle. Each run receipt/log in the requested interval is preserved raw and as deterministic gzip; `index.json` records both hashes and byte counts. The ten raw `.log` files are ignored by the repository `*.log` rule; they are retained on disk and must be force-added when staging this evidence.\n\n## Accepted validation\n\n`compiler-fixtures-1793337057616332027` passed the focused and regression validation recorded in its receipt/log: scoped and all-feature/all-target strict Clippy, minimal and Mongo/Redis checks, two ordinary variation schema tests, three application schema regressions, two additional schema regressions, three composite-default regressions, actual-Mongoose 42-case replay, and private Mongo CRUD/index verification. The compiler phase took 103.2 seconds; total capped run time was 114.658 seconds. Limits were 6 CPUs, 4 GiB memory with swap disabled, 256 PIDs, and two Cargo jobs. Minimum available memory was 9,462,595,584 bytes; peak private cache was 6,449,954,816 bytes. The configured startup threshold was 5 GiB.\n\nTwo earlier failures are intentionally retained: `compiler-1793336430628464119` exposed the shared truthy-string cast mismatch for an empty document `_id`; `compiler-1793336637743889453` exposed nested Mixed-array minimization on an empty object. The accepted implementation applies opt-in Mixed minimization and the shared truthy-string document `_id` behavior.\n\nThe production readback records 18 production containers unchanged and zero remaining task-owned containers, networks, or volumes. No deployment, push, TypeScript retirement, caller adoption, or performance benchmark was performed.\n\n## Contract boundaries\n\nRaw BSON repositories preserve missing/null/Mixed document shapes. Typed `VariationCache` and `VariationJob` DTOs are strict complete views and are not substitutes for raw storage when arbitrary Mixed values or incomplete documents matter. The oracle covers ordinary serialized inputs and BSON bytes; it does not establish parity for arbitrary JavaScript prototypes, hooks/getters, `undefined`, or sparse arrays. The schema feature is local Rust coverage; total migration remains incomplete because global dependencies and application callers are not fully migrated/adopted.\n\n## Files\n\n- `source-bindings.json` — commit/source-tree binding and verification for all 1,406 inputs.\n- `runs/` — all receipts/logs in the requested interval, with raw and gzip hashes.\n- `artifacts/moderation-variation-schema/` — all four oracle attempts and final production readback.\n- `tools/` — snapshot validator, formatter/readback helpers, all variation_schema_*.sh run scripts, packager, source materializer, and directly related source-freeze utilities.\n- `verification-summary.json` — machine-readable accepted result and scope limits.\n- `index.json` and `artifact-sha256.json` — file inventory and checksums.\n\nThe accepted final commands are `tools/variation_schema_oracle4.sh` and `tools/variation_schema_quality1.sh`. Use `tools/materialize_variation_schema_source.py` with a caller-supplied prior verified SDK source root to reconstruct the exact 1,406 hash-bound input files.\n'''
    (OUT / 'README.md').write_text(readme)

    summary = {
        'codeCommit': COMMIT,
        'acceptedRun': FINAL,
        'acceptedNodeRun': FINAL_NODE,
        'sourceTreeSha256': final_receipt['source_tree_sha256'],
        'sourceInputs': 1406,
        'gitBoundInputs': 1396,
        'reusedVerifiedPosthogSdkInputs': 10,
        'oracleCases': 42,
        'oracleFixtureSha256': ref_hash,
        'bsonHexMatched': True,
        'ordinaryVariationTests': 2,
        'applicationSchemaRegressionTests': 3,
        'additionalSchemaRegressionTests': 2,
        'compositeDefaultRegressionTests': 3,
        'mongoCrudAndIndexReplay': True,
        'quality': ['scoped strict Clippy', 'all-feature/all-target strict Clippy', 'minimal feature check', 'Mongo/Redis feature checks'],
        'compilerSeconds': 103.2,
        'elapsedSeconds': 114.658,
        'limits': final_receipt['limits'],
        'minimumAvailableBytes': final_receipt['minimum_available_bytes'],
        'peakCacheBytes': final_receipt['peak_cache_bytes'],
        'startupThresholdBytes': 5 * 1024**3,
        'productionUnchanged': True,
        'productionContainers': 18,
        'remainingOwnedResources': {'containers': 0, 'networks': 0, 'volumes': 0},
        'deployment': False,
        'push': False,
        'typescriptRetirement': False,
        'callerAdoption': False,
        'performanceBenchmark': False,
        'limitations': [
            'Raw BSON repositories accept missing, null, and Mixed document shapes; typed DTOs are strict complete views.',
            'The fixture does not cover arbitrary JavaScript prototypes, hooks/getters, undefined, or sparse arrays.',
            'Local feature coverage does not complete total migration; global dependencies and application callers remain incomplete.',
        ],
        'failedAttempts': {
            'compiler-1793336430628464119': 'empty document _id String cast mismatch',
            'compiler-1793336637743889453': 'nested Mixed-array empty object minimization mismatch',
        },
    }
    (OUT / 'verification-summary.json').write_text(json.dumps(summary, indent=2, sort_keys=True) + '\n')

    for p in sorted(OUT.rglob('*')):
        if p.is_file() and p.name not in ('index.json', 'artifact-sha256.json'):
            retained.setdefault(str(p.relative_to(OUT)), {'sha256': sha(p.read_bytes()), 'bytes': p.stat().st_size, 'rawSha256': sha(p.read_bytes()), 'rawBytes': p.stat().st_size, 'compressed': False})
    (OUT / 'index.json').write_text(json.dumps(retained, indent=2, sort_keys=True) + '\n')
    hashes_out = {str(p.relative_to(OUT)): sha(p.read_bytes()) for p in sorted(OUT.rglob('*')) if p.is_file() and p.name != 'artifact-sha256.json'}
    (OUT / 'artifact-sha256.json').write_text(json.dumps(hashes_out, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'output': str(OUT), 'gitBoundInputs': len(tracked), 'reusedSdkInputs': len(sdk), 'sourceInputs': len(hashes), 'retainedRuns': len(runs), 'files': len(hashes_out), 'oracleSha256': ref_hash}, sort_keys=True))

if __name__ == '__main__':
    main()
