"""Package parent-owned migration evidence after final verification."""
import gzip, hashlib, json, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path('/root/saas-rust')
STATE = Path('/root/.local/state/rust-full-migration-20261028-lu443ytp')
ART = STATE / 'artifacts'
PACK = ROOT / 'migration-notes/evidence/2026-10-29-pricing-emote-bootstrap'
TOOLS = Path('/tmp/dimabot-full-migration-tools')

def sha(data): return hashlib.sha256(data).hexdigest()
def write(name, value):
    p = PACK / name; p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, indent=2) + '\n')
def git_bytes(commit, path):
    return subprocess.check_output(['git','show',f'{commit}:{path}'],cwd=ROOT)

if __name__ == '__main__':
    optimized_commit, compiler_run, node_post = sys.argv[1:]
    receipt = json.loads((ART / f'{compiler_run}-receipt.json').read_text())
    post = json.loads((ART / f'{node_post}-receipt.json').read_text())
    assert receipt['success'] and post['success'] and receipt['source_tree_sha256'] == post['source_tree_sha256']
    assert not PACK.exists(), 'Never overwrite a prior evidence pack'
    PACK.mkdir(parents=True)
    compressed = {}
    def retain(relative, raw, already_gz=False):
        destination = PACK / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if already_gz:
            destination.write_bytes(raw); plain = gzip.decompress(raw)
            compressed[str(destination.relative_to(PACK))] = {'sha256':sha(plain),'bytes':len(plain)}
        elif len(raw) > 32_000 or str(relative).endswith('.log'):
            destination = Path(str(destination)+'.gz')
            destination.write_bytes(gzip.compress(raw,mtime=0))
            compressed[str(destination.relative_to(PACK))] = {'sha256':sha(raw),'bytes':len(raw)}
        else: destination.write_bytes(raw)
    runs = []
    for p in sorted(ART.glob('*-receipt.json')):
        m = re.search(r'-(\d+)-receipt\.json$',p.name)
        if not m or int(m[1]) < 1793250000000000000: continue
        v = json.loads(p.read_text()); assert v['production_unchanged']
        retain(Path('runs') / p.name,p.read_bytes())
        log = p.with_name(p.name.replace('-receipt.json','.log'))
        retain(Path('runs') / log.name,log.read_bytes())
        runs.append({'receipt':str(Path('runs')/p.name),'success':v['success'],'phase':v['phase'],'source_tree_sha256':v['source_tree_sha256']})
    for dirname in ['pricing-emote-bootstrap','pricing-emote-bootstrap-vm-diagnostic']:
        for p in sorted((ART/dirname).rglob('*')):
            if p.is_file():
                assert not p.is_symlink()
                retain(Path('artifacts')/p.relative_to(ART),p.read_bytes(),p.suffix=='.gz')
    for p in sorted(ART.glob('pricing-bootstrap*.sha256')):
        retain(Path('checksums')/p.name,p.read_bytes())
    for filename in ['validate.py','apply_format.py','pricing-bootstrap-node.sh','pricing-bootstrap.sh','pricing-bootstrap-optimized.sh','pricing_bootstrap_provenance.cjs','package_pricing_bootstrap.py']:
        retain(Path('recorded-verifier')/filename,(TOOLS/filename).read_bytes())
    bindings = {}
    baseline = json.loads((ART/'pricing-emote-bootstrap/source-commits-baseline.json').read_text())
    for group in baseline:
        for path in group['paths']: bindings[path] = group['commit']
    bindings['dimabot/src/utils/tts/usage.rs'] = optimized_commit
    bindings['dimabot/tests/fixtures/js_round_reference.cjs'] = optimized_commit
    for name in ['Cargo.toml','Cargo.lock','rust-toolchain.toml']:
        bindings[f'dimabot/{name}'] = baseline[-1]['commit']
    recorded = {}
    for path,commit in bindings.items():
        raw = git_bytes(commit,path)
        assert sha(raw) == receipt['source_hashes'][path] == sha((ROOT/path).read_bytes()),path
        recorded[path] = {'commit':commit,'sha256':sha(raw)}
    write('source-binding.json',{'source_tree_sha256':receipt['source_tree_sha256'],'files':recorded})
    log = (ART/f'{compiler_run}.log').read_text()
    passed = sum(map(int,re.findall(r'test result: ok\. (\d+) passed;',log)))
    summary = {'sourceTreeSha256':receipt['source_tree_sha256'],'compilerRun':compiler_run,'nodePostRun':node_post,'ordinaryExecutions':passed-6,'explicitFixtureExecutions':5,'releaseBenchmarkExecutions':1,'allExecutions':passed,'limits':receipt['limits'],'peakCacheBytes':receipt['peak_cache_bytes'],'minimumHostAvailableBytes':receipt['minimum_available_bytes'],'compilerScriptSeconds':receipt['steps'][-1]['seconds'],'compilerTotalSeconds':receipt['elapsed_seconds'],'runs':runs,'sourceBindings':len(recorded),'checks':'fmt; standalone credit-policy, twitch-emotes and tts-utilities all-target check and strict Clippy; all-features all-target check and strict Clippy; no-default-features all-target check; exact source and native disposable fixture replays; matched release benchmark'}
    write('verification-summary.json',summary)
    write('compressed-artifacts.json',compressed)
    for rel,expected in compressed.items():
        raw = gzip.decompress((PACK/rel).read_bytes())
        assert sha(raw)==expected['sha256'] and len(raw)==expected['bytes'],rel
    # README and visualization are authored by the parent after metrics review.
    print(json.dumps({'pack':str(PACK),'sourceBindings':len(recorded),'ordinary':passed-6,'explicit':5,'benchmark':1,'compressed':len(compressed)},indent=2))
