"""Retain the exact isolated verification evidence; never copy runtime binaries."""
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
PACK = ROOT / 'migration-notes/evidence/2026-10-29-ai-credit-receipt'
TOOLS = Path(__file__).parent

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def write(name, value):
    p = PACK / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, indent=2) + '\n')

def main():
    compiler_run, node_post = sys.argv[1:]
    final = json.loads((ART / f'{compiler_run}-receipt.json').read_text())
    post = json.loads((ART / f'{node_post}-receipt.json').read_text())
    assert final['success'] and post['success']
    assert final['source_tree_sha256'] == post['source_tree_sha256']
    assert final['production_unchanged'] and post['production_unchanged']
    assert not PACK.exists(), 'Never overwrite prior evidence'
    PACK.mkdir(parents=True)
    compressed = {}
    def retain(relative, raw):
        relative = Path(relative)
        if len(raw) > 32000 or relative.suffix == '.log':
            relative = Path(str(relative) + '.gz')
            compressed[str(relative)] = {'sha256': sha(raw), 'bytes': len(raw)}
            stored = gzip.compress(raw, mtime=0)
        else:
            stored = raw
        dest = PACK / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(stored)
        return str(relative)
    runs = []
    for p in sorted(ART.glob('*-receipt.json')):
        m = re.search(r'-(\d+)-receipt.json$', p.name)
        if not m or int(m[1]) < 1793254981405544348:
            continue
        r = json.loads(p.read_text())
        assert r['production_unchanged'], p.name
        receipt_path = retain(Path('runs') / p.name, p.read_bytes())
        log = p.with_name(p.name.replace('-receipt.json', '.log'))
        log_path = retain(Path('runs') / log.name, log.read_bytes())
        runs.append({'receipt': receipt_path, 'log': log_path,
                     'phase': r['phase'], 'success': r['success'],
                     'source_tree_sha256': r['source_tree_sha256']})
    excluded = []
    for dirname in ['ai-credit-receipt', 'ai-credit-receipt-baseline']:
        for p in sorted((ART / dirname).rglob('*')):
            if not p.is_file():
                continue
            assert not p.is_symlink()
            rel = p.relative_to(ART)
            if p.parent.name == 'runtime-provenance' and p.name != 'files.json':
                excluded.append({'path': str(rel), 'sha256': sha(p.read_bytes()),
                                 'bytes': p.stat().st_size})
            else:
                retain(Path('artifacts') / rel, p.read_bytes())
    assert {Path(r['path']).name for r in excluded} == {'node', 'typescript', 'typescriptPackage'}
    write('runtime-provenance-exclusions.json', excluded)
    for p in sorted(ART.glob('ai-credit-receipt*.sha256')):
        retain(Path('checksums') / p.name, p.read_bytes())
    for name in ['validate.py', 'apply_format.py', 'ai-credit-receipt-node.sh',
                 'ai-credit-receipt.sh', 'ai_credit_receipt_provenance.cjs',
                 'ai-credit-receipt-optimized-node.sh', 'ai-credit-receipt-optimized.sh',
                 'ai_credit_receipt_rebind.cjs',
                 'package_ai_credit_receipt.py']:
        retain(Path('recorded-verifier') / name, (TOOLS / name).read_bytes())
    selected = {'dimabot/Cargo.toml', 'dimabot/Cargo.lock', 'dimabot/rust-toolchain.toml',
                'dimabot/src/utils/mod.rs', 'dimabot/src/utils/ai_credit_projection.rs',
                'dimabot/tests/ai_credit_projection.rs', 'dimabot/tests/ai_credit_projection_redis.rs',
                'dimabot/tests/ai_credit_projection_support/mod.rs',
                'dimabot/tests/ai_usage_producer_redis.rs',
                'dimabot/tests/support/ai_usage_producer.rs'}
    producer = json.loads((ART/'ai-credit-receipt/producer/ai_usage_producer_reference.json').read_text())
    benchmark = json.loads((ART/'ai-credit-receipt/producer-benchmark/ai-usage-producer-benchmark-input.json').read_text())
    for hashes in [producer['metadata']['hashes'], benchmark['hashes']]:
        selected.update('dimabot/' + k for k in hashes if '/' in k)
    selected.update(['dimabot/src/utils/billing.ts', 'dimabot/tests/fixtures/ai_credit_projection_reference.cjs',
                     'dimabot/tests/fixtures/ai_usage_producer_reference.cjs',
                     'dimabot/tests/fixtures/ai_usage_producer_source.cjs'])
    bindings = {}
    for path in sorted(selected):
        commit = subprocess.check_output(['git', 'log', '-1', '--format=%H', '--', path], cwd=ROOT, text=True).strip()
        assert commit, path
        raw = subprocess.check_output(['git', 'show', f'{commit}:{path}'], cwd=ROOT)
        assert sha(raw) == sha((ROOT/path).read_bytes()) == final['source_hashes'][path], path
        bindings[path] = {'commit': commit, 'sha256': sha(raw)}
    write('source-binding.json', {'source_tree_sha256': final['source_tree_sha256'], 'files': bindings})
    baseline = json.loads((ART/'ai-credit-receipt-baseline/baseline-provenance.json').read_text())
    base_receipt = json.loads((ART/f"{baseline['compilerRun']}-receipt.json").read_text())
    base_bindings = {}
    for path in sorted(selected):
        raw = subprocess.check_output(['git', 'show', f"{baseline['producerCommit']}:{path}"], cwd=ROOT)
        assert sha(raw) == base_receipt['source_hashes'][path], path
        base_bindings[path] = {'commit': baseline['producerCommit'], 'sha256': sha(raw)}
    write('baseline-source-binding.json', {'source_tree_sha256': base_receipt['source_tree_sha256'], 'files': base_bindings})
    log = (ART / f'{compiler_run}.log').read_text()
    totals = [int(n) for n in re.findall(r'test result: ok\. (\d+) passed;', log)]
    # Explicit fixture targets: projection replay, six credit Redis tests (one
    # subprocess-only no-op entry), producer replay, one producer Redis test.
    summary = {'sourceTreeSha256': final['source_tree_sha256'], 'compilerRun': compiler_run,
               'nodePostRun': node_post, 'allReportedTestExecutions': sum(totals),
               'testTargetPassedCounts': totals, 'limits': final['limits'],
               'peakCacheBytes': final['peak_cache_bytes'],
               'minimumHostAvailableBytes': final['minimum_available_bytes'],
               'compilerScriptSeconds': final['steps'][-1]['seconds'],
               'compilerTotalSeconds': final['elapsed_seconds'],
               'runs': runs, 'sourceBindings': len(bindings),
               'coverage': {'creditSourceCases': 1956, 'producerReceiptCases': 338,
                            'producerRetentionCases': 20, 'producerSourceAssertions': 3325},
               'baselineCompilerRun': baseline['compilerRun'],
               'baselineNodePostRun': baseline['nodePostRun'],
               'baselineReportedTestExecutions': sum(map(int, re.findall(r'test result: ok\. (\d+) passed;', (ART/f"{baseline['compilerRun']}.log").read_text()))),
               'checks': 'Baseline: fmt, both standalone feature all-target check and strict Clippy, all-features all-target check and strict Clippy, no-default-feature all-target check, ordinary dependency regressions, exact source and real disposable Redis replays, release benchmark. Final producer-only change: fmt, producer ordinary/source/private Redis replays, producer standalone and all-feature all-target check/strict Clippy, no-feature check, release benchmark. Unchanged credit and TTS behavior evidence remains tied to baseline source bindings.',
               'notes': 'Execution totals include overlapping dependencies and a subprocess-only no-op helper entry, not unique test cases. No production mutation, caller adoption, source retirement, deployment or push.'}
    write('verification-summary.json', summary)
    write('compressed-artifacts.json', compressed)
    for name, expected in compressed.items():
        raw = gzip.decompress((PACK/name).read_bytes())
        assert sha(raw) == expected['sha256'] and len(raw) == expected['bytes']
    print(json.dumps({'pack': str(PACK), 'sourceBindings': len(bindings),
                      'reportedExecutions': sum(totals), 'compressed': len(compressed)}, indent=2))

if __name__ == '__main__':
    main()
