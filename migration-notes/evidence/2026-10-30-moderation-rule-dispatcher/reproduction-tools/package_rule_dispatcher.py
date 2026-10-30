#!/usr/bin/env python3
"""Package the verified moderation rule dispatcher evidence; run after commit."""
import gzip
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path('/root/saas-rust')
STATE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
ART = STATE / 'artifacts'
WAVE = ART / 'moderation-rule-dispatcher/attempt1'
OUT = ROOT / 'migration-notes/evidence/2026-10-30-moderation-rule-dispatcher'
TOOLS = Path(__file__).resolve().parent
COMMIT = 'c90cdd98'
DIGEST = '050b65cf06adb805637948c65ab2010b23dde85fc3a263654dc8dd9ca6d62170'
FORMAT_DIGEST = '543049766cc1e1043391b146ab7ee6e9bad207efd2681c138e8969fd15b23089'
ACCEPTED = ['node-1793324608846532854', 'compiler-1793324608852932493', 'compiler-1793324693380466159']
FORMAT = 'format-1793324584169033656'
GIB = 1024 ** 3


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(path.read_text())


def main():
    require(not OUT.exists() or sorted(p.name for p in OUT.iterdir()) == ['README.md'], f'output already contains artifacts: {OUT}')
    commit = subprocess.check_output(['git', 'rev-parse', '--verify', COMMIT + '^{commit}'], cwd=ROOT, text=True).strip()
    receipts = {run: load(ART / (run + '-receipt.json')) for run in [FORMAT] + ACCEPTED}
    hashes = receipts[ACCEPTED[0]]['source_hashes']
    require(len(hashes) == 1369, 'unexpected source count')
    for run, r in receipts.items():
        phase = run.split('-')[0]
        require(r['phase'] == phase and r['success'] is True and r['limits_verified'] is True
                and r['production_unchanged'] is True and all(x['exit_code'] == 0 for x in r['steps']),
                f'failed receipt: {run}')
        require(r['source_tree_sha256'] == (FORMAT_DIGEST if run == FORMAT else DIGEST), f'source digest: {run}')
        if run != FORMAT:
            require(r['source_hashes'] == hashes, f'source map: {run}')
        limit = r['limits']
        require(limit['cpus'] == 6 and limit['memory'] == limit['memory_swap'] == 4 * GIB
                and limit['pids'] == 256 and limit['cargo_jobs'] == (None if phase == 'node' else 2),
                f'limits: {run}')
        require(r['headroom_start']['mem_available_bytes'] >= 5 * GIB and r['minimum_available_bytes'] >= 4 * GIB,
                f'headroom: {run}')
        if phase != 'node':
            require(r['peak_cache_bytes'] <= 8 * GIB, f'cache: {run}')
        require((ART / (run + '.log')).is_file(), f'missing log: {run}')
    sdk_reference = load(ROOT / 'migration-notes/evidence/2026-10-29-ai-ledger-persistence/source-binding.json')['unchangedArchiveVerifiedSdkReferences']
    git_hashes, sdk_hashes = {}, {}
    for name, digest in hashes.items():
        if name.startswith('verification/'):
            require(name in sdk_reference and sdk_reference[name] == digest, f'SDK mismatch: {name}')
            sdk_hashes[name] = digest
        else:
            content = subprocess.check_output(['git', 'show', commit + ':' + name], cwd=ROOT)
            require(sha(content) == digest, f'git mismatch: {name}')
            git_hashes[name] = digest
    require(len(git_hashes) == 1359 and len(sdk_hashes) == 10, 'unexpected SDK/git counts')
    proof = load(WAVE / 'independent-reference-readback.json')
    fixture = WAVE / 'reference/moderation-rule-dispatcher-reference.json'
    require(proof['sourceSnapshot'] == DIGEST and proof['cases'] == 22
            and proof['fixtureSha256'] == sha(fixture.read_bytes()), 'fixture proof mismatch')
    production = load(WAVE / 'final-production.json')
    acknowledged = STATE / 'production-baselines/piper-removal-acknowledged-2026-10-30'
    before, after, ack = (load(acknowledged / name) for name in ('before.json', 'after.json', 'acknowledgement.json'))
    require(len(before) == 19 and len(after) == 18 and set(before) - set(after) == {'/piper-tts'}
            and all(before[k] == v for k, v in after.items()) and ack['remainingUnchanged'] == 18,
            'production acknowledgement mismatch')
    owned = production['remainingOwnedResources']
    require(production['productionUnchanged'] is True and production['productionRecords'] == 18
            and production['productionRecordsAfter'] == after and set(owned) == {'containers', 'networks', 'volumes'}
            and all(not x for x in owned.values()), 'production readback mismatch')
    names = {'validate.py', 'apply_format.py', 'prepare_posthog_sdk.py', 'final_readback.py',
             'freeze_rule_dispatcher.py', 'freeze_redis_application.py', 'freeze_seed_retirement.py',
             'freeze_seed_plan.py', 'freeze_offenses.py', 'freeze_permit.py', Path(__file__).name}
    require(all((TOOLS / name).is_file() for name in names), 'missing required reproduction tool')
    scripts = sorted(TOOLS.glob('rule_dispatcher*.sh'))
    require(scripts, 'missing dispatcher check scripts')
    OUT.mkdir(parents=True, exist_ok=True)
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
        require(not dest.exists(), f'duplicate: {dest}')
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        retained[str(relative)] = {'storedPath': str(stored), 'rawSha256': sha(raw), 'rawBytes': len(raw)}
    def write(name, data):
        (OUT / name).write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')
    for path in sorted(WAVE.rglob('*')):
        if path.is_file():
            keep(path, Path('artifacts') / path.relative_to(WAVE))
    for run in [FORMAT] + ACCEPTED:
        for suffix in ('-receipt.json', '.log'):
            path = ART / (run + suffix)
            keep(path, Path('runs') / path.name)
    for path in sorted(acknowledged.iterdir()):
        if path.is_file():
            keep(path, Path('production-baseline') / path.name)
    for path in sorted([TOOLS / name for name in names] + scripts):
        keep(path, Path('reproduction-tools') / path.name)
    write('source-binding.json', {'gitCommit': commit, 'sourceTreeSha256': DIGEST, 'sourceCount': len(hashes),
          'gitFileHashes': git_hashes, 'unchangedArchiveVerifiedSdkReferences': sdk_hashes})
    receipt_summary = {run: {key: value for key, value in r.items() if key != 'source_hashes'}
                       for run, r in receipts.items()}
    write('verification-summary.json', {'codeCommit': commit, 'sourceTreeSha256': DIGEST,
          'acceptedRuns': ACCEPTED, 'formatRun': FORMAT, 'formatSourceTreeSha256': FORMAT_DIGEST,
          'receipts': receipt_summary, 'referenceCases': 22, 'fixtureSha256': proof['fixtureSha256'],
          'ordinaryHelperRegressionTests': {'blacklist': 7, 'caps': 4, 'emote': 2, 'links': 4,
                                            'normalize': 1, 'dispatcher': 1, 'total': 19},
          'fullReferenceReplayCases': 22, 'productionRecords': 18, 'remainingOwnedResources': owned,
          'performanceMeasured': False, 'deploymentPerformed': False, 'typescriptRetirement': False,
          'remainingGap': 'Partial RegExp coverage remains; this pure dispatcher does not complete migration.'})
    write('retained-artifacts.json', retained)
    write('compressed-artifacts.json', compressed)
    write('artifact-sha256.json', {str(path.relative_to(OUT)): sha(path.read_bytes())
          for path in sorted(OUT.rglob('*')) if path.is_file() and path.name != 'artifact-sha256.json'})
    print(json.dumps({'output': str(OUT), 'sourceCount': len(hashes), 'acceptedRuns': len(ACCEPTED)}))


if __name__ == '__main__':
    main()
